import { Component } from 'react';

// There was no error boundary anywhere in this app, so a single bad render
// (e.g. Progress.jsx calling status.toUpperCase() on a malformed SSE frame)
// unmounts the whole page. `resetKey` lets a parent clear the caught error
// when it changes (e.g. on route change) so navigating away recovers.
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="sx-error-box">
          <div className="sx-error-title">SOMETHING WENT WRONG</div>
          <div>{String(this.state.error?.message || this.state.error)}</div>
        </div>
      );
    }
    return this.props.children;
  }
}
