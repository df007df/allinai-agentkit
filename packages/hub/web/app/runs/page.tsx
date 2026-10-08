import {
  ConsoleApp,
  type ConsoleSection,
} from "@allin-ai/agentkit-hub/console-ui";

const section: ConsoleSection = "runs";

export default function RunsPage() {
  return <ConsoleApp section={section} />;
}
