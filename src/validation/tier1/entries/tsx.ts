import { renderTsx } from "../../../gallery-web/frame/renderers/tsx";
import { createRendererRegistry } from "../../../gallery-web/frame/renderers/registry";
import { startTier1Harness } from "../harness-entry";

startTier1Harness(createRendererRegistry([["tsx", renderTsx]]));
