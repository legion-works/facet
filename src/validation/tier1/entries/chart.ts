import { renderChart } from "../../../gallery-web/frame/renderers/chart";
import { createRendererRegistry } from "../../../gallery-web/frame/renderers/registry";
import { startTier1Harness } from "../harness-entry";

startTier1Harness(createRendererRegistry([["chart", renderChart]]));
