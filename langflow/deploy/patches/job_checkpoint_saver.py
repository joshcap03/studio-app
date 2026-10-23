"""Durable LangGraph checkpoint saver for agent tool-approval HITL (LE-1447).

Persists the paused agent thread (the interrupted checkpoint + its pending writes,
including ``__interrupt__``) into the job-scoped durable store so an approval can be
resumed after a restart. The langgraph checkpoint is NOT JSON-native (channel values
hold raw messages; writes hold Interrupt tuples), so each value is encoded with the
saver's own serde (``dumps_typed`` → ``('msgpack', bytes)``) and base64'd into the
JSON blob — ``json.dumps``/``dumpd`` would lose the Interrupt.

Only the latest checkpoint is kept (resume loads the latest). The store handle is
INJECTED (two async callables) so lfx never imports langflow.

Studio patch (langflow/deploy/Dockerfile copies this over Langflow 1.12.4's file):
LangGraph saves checkpoints in the background, one after another, but saves each
step's writes as soon as the step ends. A write can therefore arrive before the
checkpoint it belongs to, ``__interrupt__`` included. Upstream, ``aput`` reset the
writes to ``[]``, wiping that interrupt: the run then "completed" with no reply and
no approval card whenever the database was slower than the agent. Here every write
records the checkpoint it belongs to (``config``'s checkpoint_id) and is kept until
that checkpoint is superseded, so ``aget_tuple`` returns the latest checkpoint with
all of its writes whatever order they landed in.
"""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver, CheckpointTuple

_KIND = "agent"
_ASYNC_ONLY = "JobCheckpointSaver is async-only; use the a* methods."

SaveBlob = Callable[[str, str, str], Awaitable[None]]
LoadBlob = Callable[[str, str], Awaitable[str | None]]


class JobCheckpointSaver(BaseCheckpointSaver):
    def __init__(self, job_id: str, save_blob: SaveBlob, load_blob: LoadBlob) -> None:
        super().__init__()
        self._job_id = job_id
        self._save_blob = save_blob
        self._load_blob = load_blob
        self._lock = asyncio.Lock()

    def _encode(self, value: Any) -> list[str]:
        type_, data = self.serde.dumps_typed(value)
        return [type_, base64.b64encode(data).decode("ascii")]

    def _decode(self, pair: list[str]) -> Any:
        type_, b64 = pair
        return self.serde.loads_typed((type_, base64.b64decode(b64)))

    async def _read(self) -> dict[str, Any]:
        raw = await self._load_blob(self._job_id, _KIND)
        return json.loads(raw) if raw else {}

    @staticmethod
    def _result_config(blob: dict[str, Any]) -> dict[str, Any]:
        return {
            "configurable": {
                "thread_id": blob.get("thread_id"),
                "checkpoint_ns": blob.get("checkpoint_ns", ""),
                "checkpoint_id": blob.get("checkpoint_id"),
            }
        }

    @staticmethod
    def _write_owner(write: list[Any], blob: dict[str, Any]) -> Any:
        # Writes saved before this patch carry no checkpoint id: they belong to the blob's.
        return write[4] if len(write) > 4 else blob.get("checkpoint_id")

    async def aput(self, config, checkpoint, metadata, new_versions) -> dict[str, Any]:  # noqa: ARG002
        configurable = config.get("configurable", {})
        async with self._lock:
            # A new checkpoint supersedes the prior ones and their writes. Writes that
            # arrived early, for this checkpoint or a later one, are kept.
            prior = await self._read()
            superseded = set(prior.get("superseded", []))
            if prior.get("checkpoint_id"):
                superseded.add(prior["checkpoint_id"])
            superseded.discard(checkpoint["id"])
            writes = [w for w in prior.get("writes", []) if self._write_owner(w, prior) not in superseded]
            blob = {
                "v": 1,
                "thread_id": configurable.get("thread_id"),
                "checkpoint_ns": configurable.get("checkpoint_ns", ""),
                "checkpoint_id": checkpoint["id"],
                "checkpoint": self._encode(checkpoint),
                "metadata": self._encode(metadata),
                "writes": writes,
                # Ids are time-ordered UUIDs (uuid6), so the newest are kept.
                "superseded": sorted(superseded)[-64:],
            }
            await self._save_blob(self._job_id, _KIND, json.dumps(blob))
        return self._result_config(blob)

    async def aput_writes(self, config, writes: Sequence[tuple[str, Any]], task_id: str, task_path: str = "") -> None:  # noqa: ARG002
        owner = config.get("configurable", {}).get("checkpoint_id")
        async with self._lock:
            blob = await self._read()
            if owner is None:
                owner = blob.get("checkpoint_id")
            if owner is None or owner in blob.get("superseded", []):
                return
            stored = blob.setdefault("writes", [])
            for channel, value in writes:
                stored.append([task_id, channel, *self._encode(value), owner])
            await self._save_blob(self._job_id, _KIND, json.dumps(blob))

    async def aget_tuple(self, config) -> CheckpointTuple | None:
        blob = await self._read()
        if "checkpoint" not in blob:
            return None
        requested = config.get("configurable", {}).get("checkpoint_id")
        if requested is not None and requested != blob.get("checkpoint_id"):
            return None
        pending_writes = [
            (w[0], w[1], self._decode([w[2], w[3]]))
            for w in blob.get("writes", [])
            if self._write_owner(w, blob) == blob.get("checkpoint_id")
        ]
        return CheckpointTuple(
            config=self._result_config(blob),
            checkpoint=self._decode(blob["checkpoint"]),
            metadata=self._decode(blob["metadata"]),
            parent_config=None,
            pending_writes=pending_writes,
        )

    async def alist(self, config, *, filter=None, before=None, limit=None):  # noqa: A002, ARG002
        tuple_ = await self.aget_tuple(config)
        if tuple_ is not None:
            yield tuple_

    def put(self, *args, **kwargs):
        raise NotImplementedError(_ASYNC_ONLY)

    def put_writes(self, *args, **kwargs):
        raise NotImplementedError(_ASYNC_ONLY)

    def get_tuple(self, *args, **kwargs):
        raise NotImplementedError(_ASYNC_ONLY)
