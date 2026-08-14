import { installGalleryFrameApi } from "../runtime";
import { renderHtml } from "../renderers/html";
import { createRendererRegistry } from "../renderers/registry";

const registry = createRendererRegistry([["html", renderHtml]]);
installGalleryFrameApi(registry);
