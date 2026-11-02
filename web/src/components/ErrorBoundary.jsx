import { Component } from 'react';
import { Button } from './ui/controls.jsx';

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
      // React 19 already logs caught errors to the console; users get a plain message, not the raw error.
      return (
        <div className="sx-error-box" role="alert">
          <div className="sx-error-title">SOMETHING WENT WRONG</div>
          <p>This part of the page stopped working. Reloading usually fixes it.</p>
          <Button onClick={() => window.location.reload()}>RELOAD PAGE</Button>
        </div>
      );
    }
    return this.props.children;
  }
}
