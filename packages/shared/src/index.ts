export {
  MessageType,
  encodeMessage,
  decodeMessage,
  type ProtocolMessage,
  type OutputMessage,
  type InputMessage,
  type ResizeMessage,
  type HeartbeatMessage,
  type SessionCreatedMessage,
  type CreateSessionMessage,
  type DestroySessionMessage,
  type SessionDestroyedMessage,
  type ErrorMessage,
} from './protocol.js';

export {
  CreateSessionSchema,
  ResizeSchema,
  InputSchema,
  DestroySessionSchema,
  type CreateSessionData,
  type ResizeData,
  type InputData,
  type DestroySessionData,
} from './schemas.js';
