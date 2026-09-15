import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

export function createStore({ tableName, documentClient } = {}) {
  const client = documentClient || DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const table = tableName || process.env.TABLE_NAME;
  if (!table) throw new Error("TABLE_NAME is required.");
  async function query(input) {
    const items = [];
    let ExclusiveStartKey = input.ExclusiveStartKey;
    do {
      const result = await client.send(new QueryCommand({ TableName: table, ...input, ExclusiveStartKey }));
      items.push(...(result.Items || []));
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey && !input.Limit);
    return { items, cursor: ExclusiveStartKey };
  }
  async function batchWrite(requests) {
    for (let start = 0; start < requests.length; start += 25) {
      let pending = requests.slice(start, start + 25);
      for (let attempt = 0; pending.length && attempt < 6; attempt += 1) {
        const result = await client.send(new BatchWriteCommand({ RequestItems: { [table]: pending } }));
        pending = result.UnprocessedItems?.[table] || [];
        if (pending.length) await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 50));
      }
      if (pending.length) throw new Error(`DynamoDB left ${pending.length} writes unprocessed.`);
    }
  }
  return {
    get: (PK, SK) => client.send(new GetCommand({ TableName: table, Key: { PK, SK } })).then((result) => result.Item),
    put: (Item) => client.send(new PutCommand({ TableName: table, Item })),
    batchWrite,
    queryPartition: (PK, options = {}) => query({ KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": PK }, ...options }),
    queryKind: (kind, options = {}) => query({ IndexName: "ByKind", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": `KIND#${kind}` }, ...options }),
    async acquireLock(name, owner, nowEpoch, expiresAt) {
      try {
        await client.send(new PutCommand({ TableName: table, Item: { PK: `LOCK#${name}`, SK: "LOCK", entity: "lock", owner, expiresAt },
          ConditionExpression: "attribute_not_exists(PK) OR expiresAt < :now", ExpressionAttributeValues: { ":now": nowEpoch } }));
        return true;
      } catch (error) {
        if (error?.name === "ConditionalCheckFailedException") return false;
        throw error;
      }
    },
    async releaseLock(name, owner) {
      try {
        await client.send(new DeleteCommand({ TableName: table, Key: { PK: `LOCK#${name}`, SK: "LOCK" },
          ConditionExpression: "#owner = :owner", ExpressionAttributeNames: { "#owner": "owner" }, ExpressionAttributeValues: { ":owner": owner } }));
      } catch (error) {
        if (error?.name !== "ConditionalCheckFailedException") throw error;
      }
    },
  };
}
