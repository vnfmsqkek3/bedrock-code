import { IVpc, Peer, Port } from 'aws-cdk-lib/aws-ec2';
import { ServerlessCache } from '@aws-cdk/aws-elasticache-alpha';
import { Construct } from 'constructs';

export interface ElastiCacheProps {
  readonly vpc: IVpc;
  readonly serverlessCacheName?: string;
}

export class ElastiCache extends Construct {
  public readonly cache: ServerlessCache;

  constructor(scope: Construct, id: string, props: ElastiCacheProps) {
    super(scope, id);

    const { vpc, serverlessCacheName } = props;

    this.cache = new ServerlessCache(this, 'ServerlessCache', {
      vpc,
      serverlessCacheName,
    });

    this.cache.connections.allowFrom(
      Peer.ipv4(vpc.vpcCidrBlock),
      Port.tcp(6379),
    );
  }
}
