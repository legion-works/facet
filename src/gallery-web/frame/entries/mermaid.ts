import { startGalleryFrame } from "../bootstrap";
import { renderMermaidDocument } from "../renderers/mermaid";
import { createRendererRegistry } from "../renderers/registry";

startGalleryFrame(createRendererRegistry([["mermaid", renderMermaidDocument]]));
