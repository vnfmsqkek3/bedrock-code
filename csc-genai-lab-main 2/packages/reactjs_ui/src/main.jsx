/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import React from 'react'
import ReactDOM from 'react-dom/client'
import { Amplify } from 'aws-amplify'
import App from './App.jsx'
import './styles/index.css'
import "@aws-amplify/ui-react/styles.css"
import { loadRuntimeConfig, toAmplifyConfig } from './utils/runtimeConfig'

// Load deploy-time config (runtime-config.json) before configuring Amplify and rendering.
loadRuntimeConfig().then((cfg) => {
  Amplify.configure(toAmplifyConfig(cfg));
  ReactDOM.createRoot(document.getElementById('root')).render(
    <App />
  );
});
