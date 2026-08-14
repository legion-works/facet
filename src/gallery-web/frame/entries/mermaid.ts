import { installGalleryFrameApi } from "../runtime";
import { renderMermaidDocument } from "../renderers/mermaid";
import { createRendererRegistry } from "../renderers/registry";

const registry = createRendererRegistry([["mermaid", renderMermaidDocument]]);
installGalleryFrameApi(registry);
