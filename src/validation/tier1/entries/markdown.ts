import { renderMarkdown } from "../../../gallery-web/frame/renderers/markdown";
import { createRendererRegistry } from "../../../gallery-web/frame/renderers/registry";
import { startTier1Harness } from "../harness-entry";

startTier1Harness(createRendererRegistry([["markdown", renderMarkdown]]));
