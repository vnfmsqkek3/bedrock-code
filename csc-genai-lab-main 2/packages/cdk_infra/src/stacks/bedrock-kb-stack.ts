/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import * as path from "path";
import { PythonLayerVersion } from "@aws-cdk/aws-lambda-python-alpha";
import { bedrock, opensearchserverless, opensearch_vectorindex } from "@cdklabs/generative-ai-cdk-constructs";
import { CustomResource, Stack, StackProps, RemovalPolicy, Duration } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as oss from "aws-cdk-lib/aws-opensearchserverless";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
  Provider,
} from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

// The knowledge base construct defaults to these names; they are referenced both when
// creating the index and when re-mapping it, so keep them in one place.
// The one prefix the knowledge base ingests from. The document list, the delete endpoint
// and the auto-ingest trigger all work under it, so an object stored anywhere else is a
// source nobody can see or remove. Keep shipped samples and user uploads both under here.
const DOCUMENT_PREFIX = "documents/";
const KB_INDEX_NAME = "bedrock-knowledge-base-default-index";
const KB_TEXT_FIELD = "AMAZON_BEDROCK_TEXT_CHUNK";
import { ParserStrategyUtil } from "../utils/parser-strategy-util";

interface BedrockKnowledgeBaseStackProps extends StackProps {
  ACCESS_LOG_BUCKET: s3.Bucket;
  LAYER_BOTO: PythonLayerVersion;
  LAYER_POWERTOOLS: PythonLayerVersion;
}

export class BedrockKnowledgeBaseStack extends Stack {
  public readonly AGENT_KB: bedrock.IKnowledgeBase;
  public readonly KB_DATA_BUCKET: s3.Bucket;
  public readonly KB_DATA_SOURCE_ID: string;

  constructor(
    scope: Construct,
    id: string,
    props: BedrockKnowledgeBaseStackProps,
  ) {
    super(scope, id, props);

    // Origin allowed to upload straight into the bucket — see the cors block below.
    // "None" is what the CloudFormation lookup in remote-deploy.sh yields before a site
    // exists; treat it as absent rather than letting the literal string become an origin
    // that matches nothing and blocks every upload.
    const websiteOrigin = String(
      this.node.tryGetContext("website:origin") ?? "",
    ).trim().replace(/\/+$/, "");
    const uploadOrigins =
      websiteOrigin && websiteOrigin !== "None" ? [websiteOrigin] : ["*"];

    const agentKnowledgeBaseDataBucket = new s3.Bucket(
      this,
      "AgentKnowledgeBaseDataBucket",
      {
        enforceSSL: true,
        versioned: true,
        publicReadAccess: false,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        serverAccessLogsBucket: props.ACCESS_LOG_BUCKET,
        serverAccessLogsPrefix: "AgentKnowledgeBaseDataBucketLogs/",
        // Allow the browser to upload documents directly via presigned PUT URLs.
        //
        // PUT is what makes uploading work at all, and it is the easy one to lose: this rule
        // was once narrowed by hand to the site's origin and the hand dropped PUT and HEAD
        // along with the wildcard. Every upload failed the CORS preflight from then on, and
        // nothing reported it — /kb/upload-url still answered 200, the browser just never got
        // to use the URL. It stayed broken for a week. Keep the methods; narrow the origin.
        //
        // The origin arrives as context rather than a cross-stack reference: the distribution
        // is created in WebsiteStack, which already depends on this stack, so reading it back
        // here would close a cycle. scripts/deploy/remote-deploy.sh looks up the deployed
        // domain and passes it, which is what keeps the narrowing from being re-applied by
        // hand after every deploy. Falls back to "*" when there is no site yet (first deploy),
        // so uploads work from the start and tighten on the next one.
        cors: [
          {
            allowedMethods: [
              s3.HttpMethods.PUT,
              s3.HttpMethods.GET,
              s3.HttpMethods.HEAD,
            ],
            allowedOrigins: uploadOrigins,
            allowedHeaders: ["*"],
            // The browser reads the upload's ETag to confirm what landed.
            exposedHeaders: ["ETag"],
            maxAge: 3600,
          },
        ],
        lifecycleRules: [
          {
            id: "ArchiveOldVersions",
            enabled: true,
            noncurrentVersionTransitions: [
              {
                storageClass: s3.StorageClass.GLACIER,
                transitionAfter: Duration.days(30),
              },
            ],
            noncurrentVersionExpiration: Duration.days(90),
          },
          {
            // staging/ holds in-flight uploads and async /kb/process status JSON. Both are
            // deleted on the happy path, but an abandoned upload would otherwise sit here
            // forever — and the KB data source scans the whole bucket, so leftovers get
            // embedded as if they were real documents.
            id: "ExpireStagingLeftovers",
            enabled: true,
            prefix: "staging/",
            expiration: Duration.days(1),
          },
        ],
      },
    );

    this.KB_DATA_BUCKET = agentKnowledgeBaseDataBucket;

    // Upload sample PDF and metadata file. Exclude tooling/OS junk (.omc state,
    // macOS AppleDouble/.DS_Store) — the KB data source scans the whole bucket, so
    // anything shipped here gets embedded into OpenSearch. Only the sample docs belong.
    const sampleDocsDeployment = new s3deploy.BucketDeployment(this, "DeployProductsSampleTable", {
      sources: [
        s3deploy.Source.asset(
          path.join(__dirname, "..", "assets", "knowledgebase"),
        ),
      ],
      destinationBucket: agentKnowledgeBaseDataBucket,
      // Land the samples in the same prefix as user uploads. At the bucket root they were
      // still ingested but invisible to the document list, so they could not be deleted.
      destinationKeyPrefix: DOCUMENT_PREFIX,
      exclude: [".omc/**", "**/.omc/**", "._*", "**/._*", ".DS_Store", "**/.DS_Store"],
      // Don't prune: this deployment shares the bucket with user-uploaded documents
      // (documents/ prefix). With the default prune=true, every deploy would delete
      // anything not in the sample-docs asset — i.e. wipe all user uploads.
      prune: false,
    });

    // Dedicated bucket for multimodal-parser (DATA_AUTOMATION/FOUNDATION_MODEL) output.
    // Bedrock's supplemental data storage requires a BUCKET-ROOT URI (no sub-folder), so it
    // can't share a prefix on the data bucket — and it must NOT be the data bucket itself, or
    // the KB data source would re-ingest the parsed images. Hence a separate bucket.
    const supplementalStorageBucket = new s3.Bucket(this, "AgentKnowledgeBaseSupplementalBucket", {
      enforceSSL: true,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      serverAccessLogsBucket: props.ACCESS_LOG_BUCKET,
      serverAccessLogsPrefix: "AgentKnowledgeBaseSupplementalBucketLogs/",
    });

    // Self-managed OpenSearch Serverless vector store: create the AOSS collection
    // explicitly so we control its name/region instead of letting the construct
    // quick-create one. The construct still creates the vector index inside it.
    const vectorCollection = new opensearchserverless.VectorCollection(this, "AgentKbVectorCollection", {
      collectionName: `csc-kb-${this.region}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 32),
      standbyReplicas: opensearchserverless.VectorCollectionStandbyReplicas.DISABLED,
    });

    // Create the vector index explicitly so the Korean (Nori) analyzer can be attached to
    // it further below. Without an analyzer the default "standard" one splits on
    // whitespace/punctuation only, so inflected forms and spacing variants of the same
    // word become unrelated terms and the BM25 half of HYBRID search is wasted on Korean
    // queries.
    //
    // The construct's own `analyzer` prop is deliberately NOT used: its custom-resource
    // handler writes the analyzer into the index settings but never references it from a
    // field mapping, and does not name it `default` either, so no field ever uses it. It
    // deploys cleanly and does nothing — verified in 0.1.302 and in the latest published
    // 0.1.318. KbNoriIndex below writes the mapping that actually applies it.
    const kbVectorIndex = new opensearch_vectorindex.VectorIndex(this, "AgentKbVectorIndex", {
      collection: vectorCollection,
      indexName: KB_INDEX_NAME,
      vectorField: "bedrock-knowledge-base-default-vector",
      vectorDimensions: 1024,
      precision: "float",
      distanceType: "l2",
      mappings: [
        { mappingField: KB_TEXT_FIELD, dataType: "text", filterable: true },
        { mappingField: "AMAZON_BEDROCK_METADATA", dataType: "text", filterable: false },
      ],
    });

    // NOTE: a POST_CHUNKING custom transformation Lambda used to sit here, prepending the
    // source document's title to every chunk so structurally similar documents stayed
    // distinguishable. It was removed because it cannot work alongside a native chunking
    // strategy: with one configured, Bedrock invokes the Lambda but keeps its own chunk
    // bodies and honors only contentMetadata — contentBody edits are discarded. Injecting
    // text into chunks requires chunkingStrategy NONE and chunking implemented by hand.

    // * Amazon Bedrock
    this.AGENT_KB = new bedrock.VectorKnowledgeBase(this, "AgentKnowledgeBase", {
      embeddingsModel: bedrock.BedrockFoundationModel.TITAN_EMBED_TEXT_V2_1024,
      vectorStore: vectorCollection,
      vectorIndex: kbVectorIndex,
      instruction:
        "Use this knowledge base for answering general questions related to the company name services and offerings " +
        "It contains text of FAQ documents like how to change password, how to cancel subscription.",
      // Multimodal parsers extract images/tables into this supplemental S3 location; Bedrock
      // rejects the data source without it. Must be a bucket-root URI (no sub-folder).
      supplementalDataStorageLocations: [
        bedrock.SupplementalDataStorageLocation.s3({
          uri: `s3://${supplementalStorageBucket.bucketName}`,
        }),
      ],
    });

    // The KB service role must be able to read/write parsed output in the supplemental bucket.
    supplementalStorageBucket.grantReadWrite(this.AGENT_KB.role);

    const parserStrategyCode = this.node.tryGetContext("parser:strategy");
    let parsingStrategy: bedrock.ParsingStategy | undefined;

    if (parserStrategyCode && ParserStrategyUtil.isValid(parserStrategyCode)) {
      // Resolved by scripts/deploy/resolve_bedrock_models.py before `cdk deploy` so
      // regions without the default pinned profile get an available Claude fallback
      // instead of a Bedrock ValidationException during ingestion.
      const parserModelId = this.node.tryGetContext("parser:foundationModelId");
      parsingStrategy = ParserStrategyUtil.createStrategy(
        parserStrategyCode,
        this.region,
        this.account,
        parserModelId,
      );
    }

    // Chunking is IMMUTABLE once the data source exists — Bedrock rejects changing
    // chunkingConfiguration, so this knob only applies on the INITIAL deploy. Changing
    // it later forces CloudFormation to replace the data source (delete + recreate) and
    // you must re-ingest every document. To use several strategies at once, attach
    // multiple data sources to the KB instead. Values: hierarchical (default) | semantic
    // | fixed | none.
    //
    // Hierarchical is the default because multi-page explanation documents (PDF manuals,
    // procedures spanning several pages) need broad context for answer generation while
    // still benefiting from fine-grained retrieval. The parent chunk (1500 tokens) gives
    // the model surrounding context; the child chunk (300 tokens) keeps retrieval precise.
    const chunkingCode = (this.node.tryGetContext("chunking:strategy") || "hierarchical").toLowerCase();
    let chunkingStrategy: bedrock.ChunkingStrategy;
    switch (chunkingCode) {
      case "fixed":
        chunkingStrategy = bedrock.ChunkingStrategy.fixedSize({ maxTokens: 500, overlapPercentage: 20 });
        break;
      case "semantic":
        chunkingStrategy = bedrock.ChunkingStrategy.semantic({
          maxTokens: 1000,
          bufferSize: 1,
          breakpointPercentileThreshold: 90,
        });
        break;
      case "none":
        chunkingStrategy = bedrock.ChunkingStrategy.NONE;
        break;
      case "hierarchical":
      default:
        chunkingStrategy = bedrock.ChunkingStrategy.hierarchical({
          overlapTokens: 60,
          maxParentTokenSize: 1500,
          maxChildTokenSize: 300,
        });
        break;
    }

    const s3DataSource = new bedrock.S3DataSource(this, "S3DataSource", {
      bucket: agentKnowledgeBaseDataBucket,
      knowledgeBase: this.AGENT_KB,
      chunkingStrategy: chunkingStrategy,
      // Ingest only what the document API manages. Without this the data source scans the
      // whole bucket, so anything left at the root is indexed permanently: the document
      // list and the delete endpoint both work under this prefix, so a root object cannot
      // be removed through the UI, and every sync re-adds it after a direct delete from
      // the knowledge base. It then answers questions as a source the user cannot see.
      inclusionPrefixes: [DOCUMENT_PREFIX],
      // No fixed dataSourceName: chunking/parsing changes force CloudFormation to REPLACE
      // the data source, and a hardcoded name makes the replacement collide with the old
      // one (409 AlreadyExists). Letting CDK auto-generate a unique name lets replacement
      // succeed (create new, then delete old).
      // RETAIN: on stack delete, drop the data source WITHOUT purging the vector
      // store. DELETE (the construct default) makes CloudFormation call the KB role
      // to wipe vectors from OpenSearch first — if that role's aoss permissions are
      // broken (e.g. cross-region IAM overwrite) the delete hangs and blocks the
      // whole stack. The collection is torn down with the KB anyway, so purging is
      // redundant here.
      //
      // But the policy also governs the delete half of a REPLACEMENT, and a chunking
      // or parser change is a replacement: under RETAIN the old data source's chunks
      // stay in the index forever, so re-ingesting leaves both generations there and
      // retrieval mixes them. Nothing can clean them up afterwards either — the index
      // is reachable only by the KB role. Before deploying such a change, flip the
      // LIVE data source to DELETE first (`aws bedrock-agent update-data-source
      // --data-deletion-policy DELETE`); changing it here does not, because
      // CloudFormation deletes the old resource with the policy it already carries.
      dataDeletionPolicy: bedrock.DataDeletionPolicy.RETAIN,
      ...(parsingStrategy && { parsingStrategy }),
    });

    this.KB_DATA_SOURCE_ID = s3DataSource.dataSourceId;

    // * Auto-ingestion: S3 upload -> Lambda -> StartIngestionJob (no manual console sync)
    const ingestLambda = new lambda.Function(this, "KbIngestLambda", {
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset(
        path.join("src", "backend", "kb_management", "lambda", "kb_ingest"),
      ),
      handler: "kb_ingest.lambda_handler",
      timeout: Duration.seconds(60),
      memorySize: 256,
      layers: [props.LAYER_BOTO, props.LAYER_POWERTOOLS],
      environment: {
        POWERTOOLS_LOG_LEVEL: "INFO",
        POWERTOOLS_SERVICE_NAME: "KbIngest",
        KNOWLEDGE_BASE_ID: this.AGENT_KB.knowledgeBaseId,
        DATA_SOURCE_ID: s3DataSource.dataSourceId,
      },
    });

    ingestLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:StartIngestionJob"],
        resources: [this.AGENT_KB.knowledgeBaseArn],
      }),
    );

    // Trigger on new documents (not the staging/ upload area); sidecars are skipped inside the Lambda.
    agentKnowledgeBaseDataBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(ingestLambda),
      { prefix: "documents/" },
    );

    // Trigger on deleted documents so the KB vector index is updated (removes stale vectors).
    agentKnowledgeBaseDataBucket.addEventNotification(
      s3.EventType.OBJECT_REMOVED,
      new s3n.LambdaDestination(ingestLambda),
      { prefix: "documents/" },
    );

    // * Attach the Korean analyzer to the index's text field.
    // This has to happen HERE — after the index exists, before anything is ingested.
    // Applying an analyzer means recreating the index, and Bedrock tracks per-document
    // sync state on the data source separately from the index contents: rebuild after
    // documents have been ingested and the next ingestion job decides nothing changed,
    // skips every document, and leaves the vector store permanently empty. Running ahead
    // of InitialKbSync means there is nothing to lose and the ordinary first sync fills
    // the rebuilt index.
    const noriIndexLambda = new lambda.Function(this, "KbNoriIndexLambda", {
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset(
        path.join("src", "backend", "kb_management", "lambda", "kb_nori_index"),
        { exclude: ["test_*.py", "__pycache__", "**/__pycache__"] },
      ),
      handler: "kb_nori_index.on_event",
      // Index creation and data-access-policy propagation are both eventually consistent
      // and the handler polls through them rather than guessing a sleep.
      timeout: Duration.minutes(14),
      memorySize: 512,
      layers: [props.LAYER_BOTO, props.LAYER_POWERTOOLS],
      environment: { POWERTOOLS_LOG_LEVEL: "INFO", POWERTOOLS_SERVICE_NAME: "KbNoriIndex" },
    });
    // AOSS needs both halves: this managed policy is the IAM side (aoss:APIAccessAll)...
    noriIndexLambda.role!.addManagedPolicy(vectorCollection.aossPolicy);
    // ...and this is the collection-side data access policy naming the same principal.
    const noriAccessPolicy = new oss.CfnAccessPolicy(this, "KbNoriIndexAccessPolicy", {
      name: `nori-${this.region}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 32),
      type: "data",
      policy: JSON.stringify([{
        Rules: [
          {
            Resource: [`index/${vectorCollection.collectionName}/*`],
            ResourceType: "index",
            Permission: [
              "aoss:DescribeIndex",
              "aoss:CreateIndex",
              "aoss:DeleteIndex",
              "aoss:UpdateIndex",
            ],
          },
          {
            Resource: [`collection/${vectorCollection.collectionName}`],
            ResourceType: "collection",
            Permission: ["aoss:DescribeCollectionItems"],
          },
        ],
        Principal: [noriIndexLambda.role!.roleArn],
        Description: "",
      }]),
    });

    const noriIndex = new CustomResource(this, "KbNoriIndex", {
      serviceToken: new Provider(this, "KbNoriIndexProvider", {
        onEventHandler: noriIndexLambda,
      }).serviceToken,
      properties: {
        Endpoint: `https://${vectorCollection.collectionId}.${this.region}.aoss.amazonaws.com`,
        IndexName: KB_INDEX_NAME,
        TextField: KB_TEXT_FIELD,
        // How the documents currently in the index were read. When this changes the old
        // chunks describe the same pages a different way, and CloudFormation replaces the
        // data source without removing them, so the handler empties the index instead of
        // letting two readings of every page answer the same question.
        ParserFingerprint: `${parserStrategyCode ?? "DEFAULT"}:${
          this.node.tryGetContext("parser:foundationModelId") ?? "default"
        }`,
      },
    });
    noriIndex.node.addDependency(kbVectorIndex);
    noriIndex.node.addDependency(noriAccessPolicy);
    // Rebuilding the index under a live knowledge base is safe (same name, same fields),
    // but only once the knowledge base and its data source have finished validating it.
    noriIndex.node.addDependency(this.AGENT_KB);
    noriIndex.node.addDependency(s3DataSource);

    // * Metadata sidecars for the documents that ship with the stack.
    // Uploaded documents get their attributes generated by /kb/process; stack assets never
    // pass through it, so without this they reach the vector store with no metadata. Same
    // Lambda source as the upload API — a second entry point, not a second copy of the
    // analysis prompt. Must land before InitialKbSync: ingestion reads the sidecar that
    // exists at that moment, so a sidecar written afterwards needs a re-ingest to apply.
    const sidecarLambda = new lambda.Function(this, "KbSampleSidecarLambda", {
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset(
        path.join("src", "backend", "kb_management", "lambda", "kb_documents"),
        { exclude: ["test_*.py", "__pycache__", "**/__pycache__"] },
      ),
      handler: "kb_documents.sidecar_handler",
      // TWO Converse calls per shipped document: one to derive its metadata, one to
      // transcribe its pages (the companion the upload path writes — without it a document
      // with no text layer reaches the index as pictures only and answers nothing).
      // ponytail: sized for the handful of samples that ship today; it runs them one after
      // another, so enough new samples will eventually walk into this ceiling and fail the
      // deploy. Move the transcription to the async self-invoke the upload path already
      // uses (_run_process_task) when that happens — the companion write triggers S3
      // auto-ingest on its own, so it does not have to finish inside this resource.
      timeout: Duration.minutes(15),
      memorySize: 1024,
      layers: [props.LAYER_BOTO, props.LAYER_POWERTOOLS],
      environment: {
        POWERTOOLS_LOG_LEVEL: "INFO",
        POWERTOOLS_SERVICE_NAME: "KbSampleSidecar",
        KB_BUCKET: agentKnowledgeBaseDataBucket.bucketName,
        METADATA_MODEL_ID:
          this.node.tryGetContext("metadata:modelId") || "global.anthropic.claude-sonnet-4-6",
      },
    });
    agentKnowledgeBaseDataBucket.grantReadWrite(sidecarLambda);
    sidecarLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:*::foundation-model/*`,
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
        ],
      }),
    );

    const sampleSidecars = new CustomResource(this, "KbSampleSidecars", {
      serviceToken: new Provider(this, "KbSampleSidecarProvider", {
        onEventHandler: sidecarLambda,
      }).serviceToken,
      // Shipped samples and user uploads share this prefix. Uploads already arrive with a
      // sidecar and are visited only so derived attributes can be backfilled without
      // re-running the model.
      properties: { Prefixes: [DOCUMENT_PREFIX] },
    });
    sampleSidecars.node.addDependency(sampleDocsDeployment);

    // Initial sync of the shipped sample documents.
    // The S3 auto-ingest Lambda above only fires on the "documents/" prefix (reserved for
    // user uploads), and the BucketDeployment places sample PDFs at the bucket ROOT. So on
    // a fresh stack, samples sit in S3 but never enter the KB vector index — the chatbot
    // then can't cite them. Kick off a one-time StartIngestionJob after the samples land
    // and the data source is ready so the vector store is populated from turn 1.
    // Runs ONLY on stack create (no onUpdate) — we don't want to re-sync on every deploy;
    // user uploads/deletes already trigger their own ingestion jobs.
    const initialKbSync = new AwsCustomResource(this, "InitialKbSync", {
      onCreate: {
        service: "bedrock-agent",
        action: "startIngestionJob",
        parameters: {
          knowledgeBaseId: this.AGENT_KB.knowledgeBaseId,
          dataSourceId: s3DataSource.dataSourceId,
          description: "Initial sync of shipped sample documents (one-time).",
        },
        physicalResourceId: PhysicalResourceId.of(
          `${this.AGENT_KB.knowledgeBaseId}-initial-sync`,
        ),
        // A ConflictException here means an ingestion job is already in flight for this
        // data source (would be unusual on CREATE, but tolerate it): that job will cover
        // the sample docs, so treat the "conflict" as success.
        ignoreErrorCodesMatching: "ConflictException",
      },
      // Least-privilege: only allow StartIngestionJob on this KB.
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["bedrock:StartIngestionJob"],
          resources: [this.AGENT_KB.knowledgeBaseArn],
        }),
      ]),
      // The AWS SDK call itself returns immediately after the job is queued — the actual
      // embedding runs asynchronously in Bedrock. Keep the CR provider timeout short.
      timeout: Duration.minutes(2),
      // StartIngestionJob has been in the built-in Lambda SDK for a long time; skip the
      // "install latest AWS SDK" step to avoid a cold-start penalty on every deploy.
      installLatestAwsSdk: false,
    });

    // Must run AFTER the samples are uploaded AND the data source exists.
    initialKbSync.node.addDependency(sampleDocsDeployment);
    initialKbSync.node.addDependency(s3DataSource);
    // The whole point of the ordering: ingest only after the index has its final mapping
    // and every shipped document has its sidecar.
    initialKbSync.node.addDependency(noriIndex);
    initialKbSync.node.addDependency(sampleSidecars);
  }
}
