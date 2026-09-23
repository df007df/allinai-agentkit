"use client";
// AuthorizeCard reads window.location during render; it is browser-only, so
// skip server prerendering for this route entirely.
import dynamic from "next/dynamic";

const AuthorizeCard = dynamic(
  () => import("@allin-ai/agentkit/console-ui").then((m) => m.AuthorizeCard),
  { ssr: false },
);

export default function Page() {
  return <AuthorizeCard />;
}
