import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as neptune from 'aws-cdk-lib/aws-neptune';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { SSM_KEYS } from ':idp-v2/common-constructs';

export class NeptuneStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Import VPC (valueFromLookup resolves at synth time, required by Vpc.fromLookup)
    const vpcId = ssm.StringParameter.valueFromLookup(this, SSM_KEYS.VPC_ID);
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId });

    // Security Group for Neptune (allow 8182 from VPC CIDR)
    const neptuneSg = new ec2.SecurityGroup(this, 'NeptuneSG', {
      vpc,
      description: 'Neptune DB Serverless security group',
      allowAllOutbound: true,
    });
    neptuneSg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(8182),
      'Allow Neptune access from VPC',
    );

    // Subnet Group (private isolated subnets)
    const subnetGroup = new neptune.CfnDBSubnetGroup(
      this,
      'NeptuneSubnetGroup',
      {
        dbSubnetGroupDescription: 'Neptune DB Serverless subnet group',
        dbSubnetGroupName: 'idp-v2-neptune-subnet-group',
        subnetIds: vpc.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }).subnetIds,
      },
    );

    // Neptune DB Serverless Cluster
    const cluster = new neptune.CfnDBCluster(this, 'NeptuneCluster', {
      dbClusterIdentifier: 'idp-v2-neptune',
      engineVersion: '1.4.1.0',
      dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
      vpcSecurityGroupIds: [neptuneSg.securityGroupId],
      iamAuthEnabled: true,
      deletionProtection: false,
      serverlessScalingConfiguration: {
        minCapacity: 1,
        maxCapacity: 8,
      },
    });
    cluster.addDependency(subnetGroup);
    cluster.applyRemovalPolicy(RemovalPolicy.DESTROY);

    // Neptune DB Instance (serverless)
    const instance = new neptune.CfnDBInstance(this, 'NeptuneInstance', {
      dbInstanceClass: 'db.serverless',
      dbClusterIdentifier: cluster.dbClusterIdentifier!,
      dbInstanceIdentifier: 'idp-v2-neptune-instance',
    });
    instance.addDependency(cluster);
    instance.applyRemovalPolicy(RemovalPolicy.DESTROY);

    // SSM Parameters
    new ssm.StringParameter(this, 'ClusterEndpointParam', {
      parameterName: SSM_KEYS.NEPTUNE_CLUSTER_ENDPOINT,
      stringValue: cluster.attrEndpoint,
      description: 'Neptune DB Serverless cluster endpoint',
    });

    new ssm.StringParameter(this, 'ClusterPortParam', {
      parameterName: SSM_KEYS.NEPTUNE_CLUSTER_PORT,
      stringValue: cluster.attrPort,
      description: 'Neptune DB Serverless cluster port',
    });

    new ssm.StringParameter(this, 'ClusterResourceIdParam', {
      parameterName: SSM_KEYS.NEPTUNE_CLUSTER_RESOURCE_ID,
      stringValue: cluster.attrClusterResourceId,
      description: 'Neptune DB Serverless cluster resource ID',
    });

    new ssm.StringParameter(this, 'SecurityGroupIdParam', {
      parameterName: SSM_KEYS.NEPTUNE_SECURITY_GROUP_ID,
      stringValue: neptuneSg.securityGroupId,
      description: 'Neptune DB Serverless security group ID',
    });
  }
}
