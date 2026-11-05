# Copyright Amazon.com and its affiliates; all rights reserved.
# SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
# Licensed under the Amazon Software License  https://aws.amazon.com/asl/

import json
import os
import time
import uuid
import boto3
from dispatch.bedrock_chat_router import BedrockChatRouter
from aws_lambda_powertools import Logger
from aws_lambda_powertools.utilities.typing import LambdaContext
from aws_lambda_powertools.logging import correlation_paths
from dispatch.utils import generate_response

logger = Logger(use_rfc3339=True)

# Generation state handed between the two halves of a streamed answer. The streaming proxy
# runs the model itself, so retrieval output has to survive from `prepare` to `finalize` —
# it is parked here under its own key rather than passed through the proxy, which has no
# reason to carry it and would double the payload in both directions.
_STATE_TTL_SECONDS = 900
_sessions_table = boto3.resource(
    "dynamodb", region_name=os.environ.get("AWS_REGION", "ap-northeast-2")
).Table(os.environ["SESSIONS_TABLE"])


def _put_state(state: dict) -> str:
    state_key = f"genstate#{uuid.uuid4()}"
    _sessions_table.put_item(Item={
        "sessionId": state_key,
        "payload": json.dumps(state, ensure_ascii=False),
        "expiresAt": int(time.time()) + _STATE_TTL_SECONDS,
    })
    return state_key


def _get_state(state_key: str) -> dict:
    item = (_sessions_table.get_item(Key={"sessionId": state_key}) or {}).get("Item")
    if not item:
        raise KeyError(f"Generation state {state_key} not found or expired")
    return json.loads(item["payload"])


def _handle_streaming_mode(mode: str, request: dict, router: BedrockChatRouter, message: str):
    """Two halves of a streamed answer, split around generation.

    prepare  → retrieval + prompt assembly; returns what the proxy needs to call the model.
    finalize → citations, figure placement and history, from the state plus the finished text.
    """
    if mode == 'prepare':
        prepared = router.prepare_generation(message)
        if 'triage' in prepared:
            # Nothing to generate — prepare_generation already answered and recorded it.
            return generate_response(200, {
                "sessionId": router.session_id,
                "triage": prepared['triage'],
            })
        state_key = _put_state(router.externalize_state_images(prepared['state']))
        return generate_response(200, {
            "sessionId": router.session_id,
            "stateKey": state_key,
            "modelId": router.model_id,
            "systemPrompt": prepared['system_prompt'],
            "messages": prepared['messages'],
            "guardrail": ({
                "guardrailIdentifier": router.guardrail_id,
                "guardrailVersion": router.guardrail_version,
                "trace": "disabled",
            } if router.guardrail_id else None),
        })

    state_key: str = request.get('stateKey') or ''
    answer: str = request.get('answer') or ''
    if not state_key or not answer:
        return generate_response(400, {"message": "stateKey and answer are required"})

    result = router.finalize_generation(_get_state(state_key), answer)
    return generate_response(200, {
        "sessionId": router.session_id,
        "message": result["completion"],
        "citations": result["references"],
        "segments": result["segments"],
    })


@logger.inject_lambda_context(log_event=True, correlation_id_path=correlation_paths.API_GATEWAY_REST)
def lambda_handler(event: dict, context: LambdaContext):

    # Validate request is not empty
    request = json.loads(event['body']) if event['body'] else {}
    if not request:
        return generate_response(400, { 'Message' : 'No body found'})

    # Validate message is passed in the request
    session_id: str = request.get('sessionId', None)
    message: str = request.get('message', None)
    if not message:
        return generate_response(400, { 'message' : 'Message not provided'})

    # Collect optional session attributes to pass to Amazon Bedrock Agent
    session_attributes = {}
    session_attributes['principalId'] = event['requestContext'].get('authorizer', {}).get('principalId', "not passed")

    # Collect documents metadata filter
    metadata: dict = request.get('metadata', {})

    # Optional runtime overrides: which model answers, and which prompt template to apply.
    model_id: str = request.get('modelId', None)
    prompt_template: str = request.get('promptTemplate', None)
    # Optional Bedrock Guardrail to apply to the generation.
    guardrail_id: str = request.get('guardrailId', None)
    guardrail_version: str = request.get('guardrailVersion', None)

    logger.info(f'Session ID: {session_id if session_id is not None else "None"}')
    logger.info(f'Session attributes: {session_attributes if session_attributes else "None"}')
    logger.info(f'Message: {message if message is not None else "None"}')
    logger.info(f'Metadata filter: {metadata if metadata else "None"}')
    logger.info(f'Model ID: {model_id if model_id else "default"}')

    logger.info(f'Instantiating BedrockChatRouter')
    try:
        bedrock_chat_router = BedrockChatRouter(session_id, session_attributes, metadata, model_id, prompt_template, guardrail_id, guardrail_version)
    except Exception as e:
        logger.error(f'Error instantiating BedrockChatRouter: {e}')
        return generate_response(500, {"sessionId": session_id,
                                       "message" : str(e)})

    # The streaming proxy drives generation itself, in two calls around its own ConverseStream.
    # Anything else (the REST API) keeps the single-call behaviour below.
    mode: str = request.get('mode', None)
    if mode in ('prepare', 'finalize'):
        try:
            return _handle_streaming_mode(mode, request, bedrock_chat_router, message)
        except Exception as e:
            logger.exception(f'{mode} failed')
            return generate_response(500, {"sessionId": bedrock_chat_router.session_id,
                                           "message": str(e)})

    logger.info(f'Sending message to BedrockChatRouter to get agent response')
    try:
        agent_response = bedrock_chat_router.chat_with_agent(message)
    except Exception as e:
        logger.error(f'Error sending message to BedrockChatRouter: {e}')
        return generate_response(500, {"sessionId": bedrock_chat_router.session_id,
                                       "message" : str(e)})
    logger.info(f'Agent response: {agent_response}')

    client_response = {}
    if agent_response.keys().__contains__('message') and agent_response.keys().__contains__('citations'):
        logger.info(f'Returning response to client (message and citations)')
        resp_body = {
            "sessionId": bedrock_chat_router.session_id,
            "message": agent_response['message'],
            "citations": agent_response['citations']
        }
        if agent_response.get('relatedImages'):
            resp_body["relatedImages"] = agent_response['relatedImages']
        if agent_response.get('segments'):
            resp_body["segments"] = agent_response['segments']
        client_response = generate_response(200, resp_body)
    
    elif agent_response.keys().__contains__('message') and not agent_response.keys().__contains__('citations'):
        logger.info(f'Returning response to client (message only)')
        resp_body = {
            "sessionId": bedrock_chat_router.session_id,
            "message": agent_response['message'],
        }
        if agent_response.get('relatedImages'):
            resp_body["relatedImages"] = agent_response['relatedImages']
        if agent_response.get('segments'):
            resp_body["segments"] = agent_response['segments']
        client_response = generate_response(200, resp_body)
    else:
        logger.info(f'Returning response to client (no message or citations)')
        client_response = generate_response(500, {
            "sessionId": bedrock_chat_router.session_id,
            "message": "No message or citations found in agent response"
        })
    
    return client_response
    
