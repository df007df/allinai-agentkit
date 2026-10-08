import {
  ConsoleApp,
  type ConsoleSection,
} from "@allin-ai/agentkit-hub/console-ui";

const section: ConsoleSection = "issues";

export default function IssuesPage() {
  return <ConsoleApp section={section} />;
}
