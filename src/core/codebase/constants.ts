export const CodeBaseError = {
	AuthError: "AuthError",
	SyncFailed: "SyncFailed",
	CheckFileError: "CheckFileError",
}

export type CodeBaseErrorType = keyof typeof CodeBaseError
