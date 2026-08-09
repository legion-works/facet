import { createRendererRegistry } from "../../../gallery-web/frame/renderers/registry";
import { renderSvgDocument } from "../../../gallery-web/frame/renderers/svg";
import { startTier1Harness } from "../harness-entry";

startTier1Harness(createRendererRegistry([["svg", renderSvgDocument]]));
