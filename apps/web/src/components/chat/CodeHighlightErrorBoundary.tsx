// FILE: CodeHighlightErrorBoundary.tsx
// Purpose: Renders a fallback when a code/diagram highlighter throws, so a single
//          bad block never takes down the surrounding markdown timeline.
// Layer: Web chat presentation component

import React, { type ReactNode } from "react";

export class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}
