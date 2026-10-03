import { Component, type ReactNode } from "react";
import { t } from "../i18n.js";

/** Keeps a failing view from blanking the whole app. */
export class Boundary extends Component<
  { label: string; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="boot">
        <p>
          <b>{t.app.failed(this.props.label)}</b>
        </p>
        <p className="muted mono">{this.state.error.message}</p>
        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
          {t.app.retry}
        </button>
      </div>
    );
  }
}
