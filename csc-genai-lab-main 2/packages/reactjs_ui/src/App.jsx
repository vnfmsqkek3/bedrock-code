/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import React from 'react'
import { createBrowserRouter, RouterProvider } from "react-router-dom"
import { withAuthenticator } from '@aws-amplify/ui-react'
import AppShell from "./components/AppShell/AppShell"
import ChatView from "./views/ChatView/ChatView"
import SystemPrompts from "./views/SystemPrompts/SystemPrompts"
import Guardrails from "./views/Guardrails/Guardrails"
import DocumentManager from "./views/DocumentManager/DocumentManager"
import './styles/tokens.css'
import './styles/reset.css'
import './styles/animations.css'

const App = ({ signOut, user }) => {
  const router = createBrowserRouter([
    {
      path: "/",
      element: <AppShell signOut={signOut} user={user} />,
      errorElement: <div>something went wrong!</div>,
      children: [
        { index: true, element: <ChatView /> },
        { path: "bedrockagent", element: <ChatView /> },
        { path: "prompts", element: <SystemPrompts /> },
        { path: "guardrails", element: <Guardrails /> },
        { path: "knowledgebase", element: <DocumentManager /> },
      ]
    }
  ])

  return <RouterProvider router={router} />
}

export default withAuthenticator(App, {
  hideSignUp: true
})
