import { installGalleryFrameApi } from "../runtime";
import { startGalleryFrame } from "../bootstrap";
import { renderTsx } from "../renderers/tsx";
import { createRendererRegistry } from "../renderers/registry";

const registry = createRendererRegistry([["tsx", renderTsx]]);
startGalleryFrame(registry);
installGalleryFrameApi(registry);
