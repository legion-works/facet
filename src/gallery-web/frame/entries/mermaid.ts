import { installGalleryFrameApi } from "../runtime";
import { startGalleryFrame } from "../bootstrap";
import { renderMermaidDocument } from "../renderers/mermaid";
import { createRendererRegistry } from "../renderers/registry";

const registry = createRendererRegistry([["mermaid", renderMermaidDocument]]);
startGalleryFrame(registry);
installGalleryFrameApi(registry);
