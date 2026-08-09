import { renderMermaidDocument } from "../../../gallery-web/frame/renderers/mermaid";
import { createRendererRegistry } from "../../../gallery-web/frame/renderers/registry";
import { startTier1Harness } from "../harness-entry";

startTier1Harness(createRendererRegistry([["mermaid", renderMermaidDocument]]));
