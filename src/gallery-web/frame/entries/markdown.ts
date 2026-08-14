import { installGalleryFrameApi } from "../runtime";
import { startGalleryFrame } from "../bootstrap";
import { renderMarkdown } from "../renderers/markdown";
import { createRendererRegistry } from "../renderers/registry";

const registry = createRendererRegistry([["markdown", renderMarkdown]]);
startGalleryFrame(registry);
installGalleryFrameApi(registry);
