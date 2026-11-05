"""Entity Extractor Lambda

Extracts knowledge graph entities from segment analysis results.
Runs in parallel with page-description-generator and analysis-finalizer in the Distributed Map.

Modes:
  - default: Extract entities and save to S3 segment data (graph_entities)
  - test: Extract entities and return them in the output (for prompt tuning)
"""
import json

from extractor import extract_entities
from shared.s3_analysis import (
    get_segment_analysis,
    update_segment_analysis,
)


def handler(event, _context):
    print(f'Event: {json.dumps(event)}')

    workflow_id = event.get('workflow_id')
    segment_index = event.get('segment_index', 0)
    file_uri = event.get('file_uri', '')
    language = event.get('language', 'en')
    mode = event.get('mode', 'default')

    if isinstance(segment_index, dict):
        segment_index = segment_index.get('segment_index', 0)

    segment_data = get_segment_analysis(file_uri, segment_index)
    if not segment_data:
        print(f'Segment not found: {file_uri}, segment {segment_index}')
        return {
            'workflow_id': workflow_id,
            'segment_index': segment_index,
            'status': 'not_found',
            'entities': [],
        }

    entities = extract_entities(segment_data, segment_index, language)

    # Force correct segment_index on all mentions
    for ent in entities:
        for mention in ent.get('mentioned_in', []):
            mention['segment_index'] = segment_index

    print(f'Extracted {len(entities)} entities for segment {segment_index}')

    if mode == 'test':
        return {
            'workflow_id': workflow_id,
            'segment_index': segment_index,
            'status': 'test',
            'entity_count': len(entities),
            'entities': entities,
        }

    # Save to S3
    update_segment_analysis(
        file_uri, segment_index,
        graph_entities=entities,
    )

    return {
        'workflow_id': workflow_id,
        'segment_index': segment_index,
        'status': 'completed',
        'entity_count': len(entities),
    }
