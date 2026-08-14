import { installGalleryFrameApi } from "../runtime";
import { startGalleryFrame } from "../bootstrap";
import { renderHtml } from "../renderers/html";
import { createRendererRegistry } from "../renderers/registry";

const registry = createRendererRegistry([["html", renderHtml]]);
startGalleryFrame(registry);
installGalleryFrameApi(registry);
