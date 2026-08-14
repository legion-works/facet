import { installGalleryFrameApi } from "../runtime";
import { renderChart } from "../renderers/chart";
import { createRendererRegistry } from "../renderers/registry";

const registry = createRendererRegistry([["chart", renderChart]]);
installGalleryFrameApi(registry);
