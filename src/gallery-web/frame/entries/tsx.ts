import { installGalleryFrameApi } from "../runtime";
import { renderTsx } from "../renderers/tsx";
import { createRendererRegistry } from "../renderers/registry";

const registry = createRendererRegistry([["tsx", renderTsx]]);
installGalleryFrameApi(registry);
