import { installGalleryFrameApi } from "../runtime";
import { renderMarkdown } from "../renderers/markdown";
import { createRendererRegistry } from "../renderers/registry";

const registry = createRendererRegistry([["markdown", renderMarkdown]]);
installGalleryFrameApi(registry);
