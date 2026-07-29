import type { DetailedHTMLProps, HTMLAttributes } from "react";

type ModelViewerAttributes = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  src?: string;
  alt?: string;
  "auto-rotate"?: boolean;
  "camera-controls"?: boolean;
  "disable-zoom"?: boolean;
  "shadow-intensity"?: string;
  exposure?: string;
  "camera-orbit"?: string;
  "field-of-view"?: string;
  loading?: "auto" | "lazy" | "eager";
  reveal?: "auto" | "interaction" | "manual";
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": ModelViewerAttributes;
    }
  }
}

export {};
