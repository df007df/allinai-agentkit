import {
  ConsoleApp,
  type ConsoleSection,
} from "@allin-ai/agentkit-hub/console-ui";

const section: ConsoleSection = "plugins";

export default function PluginsPage() {
  return <ConsoleApp section={section} />;
}
