import { installGalleryFrameApi } from "../runtime";
import { startGalleryFrame } from "../bootstrap";
import { renderChart } from "../renderers/chart";
import { createRendererRegistry } from "../renderers/registry";

const registry = createRendererRegistry([["chart", renderChart]]);
startGalleryFrame(registry);
installGalleryFrameApi(registry);
