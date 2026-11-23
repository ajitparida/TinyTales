import React from 'react';
import { BookOpen, RefreshCw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message || 'An unexpected storybook hiccup occurred.',
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-[#FAF8F4] dark:bg-[#121624] text-[#24292E] dark:text-[#EDE9DF]">
          <div className="max-w-md w-full bg-white dark:bg-[#1A2033] border border-[#E6E1D8] dark:border-[#2A324B] rounded-2xl p-8 text-center">
            <div className="w-12 h-12 rounded-xl bg-[#2F7A5E]/10 dark:bg-[#5CA49B]/15 text-[#2F7A5E] dark:text-[#5CA49B] flex items-center justify-center mx-auto mb-4">
              <BookOpen className="w-6 h-6" />
            </div>
            <h1 className="font-display text-2xl font-semibold mb-2">
              Let us turn back to the first page
            </h1>
            <p className="text-sm text-[#5C646B] dark:text-[#A4AEC2] mb-6 leading-relaxed">
              Something interrupted the reading session. You can reload Meadowtale safely below.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-[#2F7A5E] hover:bg-[#25644C] dark:bg-[#5CA49B] dark:hover:bg-[#4A8F86] text-white dark:text-[#121624] text-sm font-semibold transition-colors whitespace-nowrap"
            >
              <RefreshCw className="w-4 h-4" />
              Reload Meadowtale
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
