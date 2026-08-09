import { startGalleryFrame } from "../bootstrap";
import { renderChart } from "../renderers/chart";
import { createRendererRegistry } from "../renderers/registry";

startGalleryFrame(createRendererRegistry([["chart", renderChart]]));
