-- Three templates' instructions said, in the member's own voice, that anything moving money "asks
-- me first". The agent read that as something the member had told it and said so back to them
-- ("you've said that needs your OK"), and it was out of date: Studio now asks once per kind of
-- payment and approves it itself after that. The templates no longer say it; this takes the same
-- sentence, exactly as the templates wrote it, out of agents already made from them. Instructions a
-- member wrote or changed in their own words aren't touched.
update public.workspace_settings
set agent_instructions = replace(replace(replace(agent_instructions,
  ' Anything that pays a fee or moves money asks me first.', ''),
  ' Anything that moves money asks me first.', ''),
  ' Anything that costs money asks me first.', '')
where agent_instructions like '%Anything that pays a fee or moves money asks me first.%'
   or agent_instructions like '%Anything that moves money asks me first.%'
   or agent_instructions like '%Anything that costs money asks me first.%';
