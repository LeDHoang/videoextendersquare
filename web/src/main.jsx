import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { ToastProvider } from './components/ui/Toast.jsx';
import { AuthProvider } from './hooks/AuthContext.jsx';
import { WalletProvider } from './hooks/WalletContext.jsx';
import './styles/tokens.css';
import './styles/global.css';
import './styles/editorial.css';

if (import.meta.env.DEV) import('./dev/palettePreview.js');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <WalletProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </WalletProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);