import { Api } from "teleproto";
import { EditMessageParams } from "teleproto/client/messages";
import { SudoDB } from "@utils/sudoDB";

function checkIfSenderIdFromSudoUser(msg: Api.Message, uid: Number): Boolean {
  const sudoDB = new SudoDB();
  const list = sudoDB.ls();
  sudoDB.close();
  if (list.find((a) => a.uid == uid)) {
    return true;
  }
  return false;
}

async function patchMsgEdit(): Promise<void> {
  const originEdit = Api.Message.prototype.edit;

  Api.Message.prototype.edit = async function (
    params: Omit<EditMessageParams, "message">
  ): Promise<Api.Message | undefined> {
    // console.log(this.senderId);
    const senderId = Number(this.senderId);
    const isSudoUser = checkIfSenderIdFromSudoUser(this, Number(this.senderId));
    const me = await this.client!.getMe();
    const meId = Number(me?.id);
    const isReply = this.isReply;
    if (isSudoUser) {
      //   return await this.client?.sendMessage(this.peerId, { message: "kkkk" });
      // return await this.edit({text: "sss"});
      // params.text = "希望 hook 成功";
      return await this.client?.sendMessage(this.peerId, {
        message: params.text,
        ...params,
      });
    }
    return await originEdit.apply(this, [params]);
  };
}

export { patchMsgEdit };
