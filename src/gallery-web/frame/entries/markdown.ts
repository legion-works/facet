import { startGalleryFrame } from "../bootstrap";
import { renderMarkdown } from "../renderers/markdown";
import { createRendererRegistry } from "../renderers/registry";

startGalleryFrame(createRendererRegistry([["markdown", renderMarkdown]]));
