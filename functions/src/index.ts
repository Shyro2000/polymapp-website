import {setGlobalOptions} from "firebase-functions";

setGlobalOptions({
  region: "europe-west1",
  maxInstances: 3,
});

export {createCompany} from "./company/createCompany";
export {inviteCompanyMember} from "./company/inviteCompanyMember";
export {
  acceptCompanyInvitation,
} from "./company/acceptCompanyInvitation";
export {
  declineCompanyInvitation,
} from "./company/declineCompanyInvitation";
export {
  withdrawCompanyInvitation,
} from "./company/withdrawCompanyInvitation";
export {
  updateCompanyMemberRole,
} from "./company/updateCompanyMemberRole";
export {
  removeCompanyMember,
} from "./company/removeCompanyMember";
export {leaveCompany} from "./company/leaveCompany";
export {
  transferCompanyOwnership,
} from "./company/transferCompanyOwnership";
export {
  importPrivateMachinesToCompany,
} from "./company/importPrivateMachinesToCompany";
export {
  updateCompanyMemberAdminData,
} from "./company/updateCompanyMemberAdminData";
export {
  updateCompanyName,
} from "./company/updateCompanyName";
