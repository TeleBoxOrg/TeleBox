import { Api } from "teleproto/tl";
import { sleep } from "teleproto/Helpers";

Api.Message.prototype.deleteWithDelay = async function (
  delay: number,
  shouldThrowError: boolean
) {
  await sleep(delay);
  try {
    return this.delete();
  } catch (e) {
    console.error(e);
    if (shouldThrowError) {
      throw e;
    }
  }
};

Api.Message.prototype.safeDelete = async function (
  { revoke }: { revoke: boolean } = { revoke: false }
) {
  try {
    return this.delete({ revoke });
  } catch (error) {
    console.log("safeDelete catch error:", error);
  }
};
