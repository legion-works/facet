import { startGalleryFrame } from "../bootstrap";
import { createRendererRegistry } from "../renderers/registry";
import { renderSvgDocument } from "../renderers/svg";

startGalleryFrame(createRendererRegistry([["svg", renderSvgDocument]]));
