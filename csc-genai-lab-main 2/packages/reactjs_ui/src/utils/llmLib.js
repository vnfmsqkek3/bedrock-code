/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import { fetchAuthSession } from 'aws-amplify/auth'
import { BedrockClient, ListFoundationModelsCommand } from "@aws-sdk/client-bedrock"

// Lists Anthropic on-demand text models for the model picker (FMPicker).
export const getFMs = async () => {
    const session = await fetchAuthSession()
    let region = session.identityId.split(":")[0]
    const client = new BedrockClient({ region: region, credentials: session.credentials })
    const input = { byProvider: "Anthropic", byOutputModality: "TEXT", byInferenceType: "ON_DEMAND" }
    const command = new ListFoundationModelsCommand(input)
    const response = await client.send(command)
    return response.modelSummaries
}
