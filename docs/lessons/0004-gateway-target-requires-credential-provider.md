# GatewayTargetはLambdaターゲットでもCredentialProviderConfigurationsが必須

`AWS::BedrockAgentCore::GatewayTarget`（CDKの`CfnGatewayTarget`）の
`credentialProviderConfigurations`プロパティは、CDKの型定義上は省略可能（optional）に
見えるが、実際のAgentCore APIはLambdaターゲットに対してもこのプロパティを必須としている。

省略して`cdk deploy`すると、実アカウントで以下のエラーでリソース作成が失敗し、
スタック全体がロールバックされる（`ROLLBACK_COMPLETE`）:

```
Resource handler returned message: "Invalid request provided:
CredentialProviderConfigurations is required for Lambda targets"
(HandlerErrorCode: InvalidRequest)
```

## 対処

GatewayのroleArn（＝ツールLambdaへの`lambda:InvokeFunction`権限を付与済みの実行ロール）を
そのまま使う場合、専用のOAuth/APIキープロバイダを別途作る必要はなく、
`credentialProviderType: 'GATEWAY_IAM_ROLE'`を指定するだけでよい
（`GATEWAY_IAM_ROLE`は`CredentialProviderType`の許容値の1つで、CDKの型定義には現れないが
CloudFormationのenum上は存在する）。

```ts
credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
```

## 教訓（一般化）

CDKのL1コンストラクト（`Cfn*`）のプロパティが`optional`と型定義されていても、
実際のサービスAPI側では条件付き必須（リソース種別によって必須/不要が変わる）ことがある。
`cdk synth`の型チェックは通っても`cdk deploy`で初めて判明するため、
本番相当のアカウントへの実デプロイでの検証を省略しない。
また、L1コンストラクトのenum値はCDKの`.d.ts`では単なる`string`型として表現され
実際の許容値が見えないことがある。`node_modules/aws-cdk-lib/core/lib/analytics-data-source/enums.js`
に主要プロパティの許容値一覧がバンドルされているため、AWS公式ドキュメントに当たれない場合の
簡易的な確認手段として使える。
