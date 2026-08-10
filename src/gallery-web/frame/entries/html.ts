import { startGalleryFrame } from "../bootstrap";
import "../styles/html-vendored.css";
import { renderHtml } from "../renderers/html";
import { createRendererRegistry } from "../renderers/registry";

startGalleryFrame(createRendererRegistry([["html", renderHtml]]));
