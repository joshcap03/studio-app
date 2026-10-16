import type { MetadataRoute } from "next";

// Lets members add Studio to their home screen as an app (and, on iOS, receive push
// notifications, which Safari only allows for installed web apps).

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Studio",
    short_name: "Studio",
    description: "An AI agent that knows your business, works in your apps, and asks before it changes anything.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fbfaf8",
    theme_color: "#fbfaf8",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
