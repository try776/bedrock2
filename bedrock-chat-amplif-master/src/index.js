import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

// Importiere Amplify v5 und die Konfigurationsdatei
import { Amplify } from 'aws-amplify';
import awsExports from './aws-exports'; 

// Konfiguriere Amplify
Amplify.configure(awsExports);

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);