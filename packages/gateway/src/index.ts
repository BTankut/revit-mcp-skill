export const gatewayScaffold = Object.freeze({
  serviceName: "revAgent Gateway",
  milestone: "M2",
  protocol: "RBP/1",
  transportImplemented: true,
  // GW-1 removed the M0 transport spike and the `bundle:legacy` graph it read
  // from: the Gateway must never load the legacy stdio entry point or an M0
  // bundle. The collected registry seed is the only legacy-derived input.
  registrySeedAvailable: true,
  m2FirstSliceAvailable: true,
  invocationAuthorityAvailable: true,
  modeADiscoveryAvailable: true,
  serviceShellAvailable: true,
} as const);

export type GatewayScaffold = typeof gatewayScaffold;

export {
  GatewayDispatcher,
  type GatewayAtomicBatchExecutorRequest,
  type GatewayDispatcherOptions,
  type GatewayDispatchOutcome,
  type GatewayDispatchRequest,
  type GatewayExecutor,
  type GatewayExecutorOutcome,
  type GatewayExecutorRequest,
  type GatewayInvocationContext,
  type GatewayJsonObject,
  type GatewayJsonValue,
} from "./dispatch.js";
export {
  GATEWAY_ATOMIC_BATCH_MAX_STEPS,
  GatewayAtomicBatchAuthorizationError,
  authorizeGatewayAtomicBatch,
  type GatewayAtomicBatchAuthorizationErrorCode,
} from "./batchDispatch.js";
export {
  GATEWAY_CONFIRM_TOKEN_FIELD,
  GATEWAY_PREVIEW_INVOCATION_FIELD,
  GatewayConfirmationControlError,
  buildConfirmationCommitProjection,
  buildConfirmationPreviewProjection,
  gatewayExternalToolInputJsonSchema,
  gatewayExternalToolInputSchema,
  splitGatewayConfirmationArguments,
  type GatewayConfirmationCommitProjection,
  type GatewayConfirmationControl,
  type GatewayConfirmationPreviewProjection,
} from "./confirmation.js";
export {
  GATEWAY_CONFIRMATION_CONTRACT_VERSION,
  GATEWAY_CONFIRMATION_AUDIT_CONTRACT_VERSION,
  GATEWAY_CONFIRMATION_AUDIT_NAMESPACE,
  GATEWAY_CONFIRMATION_NAMESPACE,
  GATEWAY_CONFIRMATION_TTL_MS,
  GatewayConfirmationAuthority,
  confirmationIdFromToken,
  confirmationSessionIdFor,
  type GatewayConfirmationAuthorityOptions,
  type GatewayConfirmationApprovalAuditRecord,
  type GatewayConfirmationProof,
  type GatewayConfirmationRefusalReason,
  type GatewayConfirmationStoreFailure,
  type GatewayConfirmationTransactionAuthority,
  type GatewayConfirmationValidationResult,
  type GatewayPendingActionBinding,
  type GatewayPendingActionIssueInput,
  type GatewayPendingActionIssueResult,
  type GatewayPendingActionRecord,
} from "./confirmationAuthority.js";
export {
  GatewayInvocationContextError,
  canonicalParamsDigest,
  createGatewayInvocationContext,
  deriveGatewayInvocationAuthority,
  currentGatewayInvocationContext,
  runWithGatewayInvocationContext,
  type GatewayDocumentIdentity,
  type GatewayInvocationContextErrorCode,
  type GatewayInvocationAuthority,
  type GatewayInvocationRoute,
  type GatewayMutationScope,
  type GatewayParamsDigest,
} from "./invocationContext.js";
export {
  NORTH_MODE_A_META_TOOLS,
  NORTH_MODE_A_PINNED_TOOLS,
  NORTH_MCP_ERROR_EVENT,
  createNorthMcpHttpHandler,
  startNorthMcpEndpoint,
  type AuthenticatedNorthMcpRequest,
  type AuthorizedNorthMcpRequest,
  type NorthMcpAuthenticatorTrustMetadata,
  type NorthMcpCallbackAuthInfo,
  type NorthMcpErrorCode,
  type NorthMcpErrorReport,
  type NorthMcpHostHeaderPolicy,
  type NorthMcpHttpHandler,
  type NorthMcpAuthenticator,
  type NorthMcpEndpointHandle,
  type NorthMcpEndpointOptions,
} from "./northMcpEndpoint.js";
export {
  GATEWAY_INSTRUCTION_PACKAGE_SCHEMA,
  GATEWAY_O6_MODULE_MANIFEST_SCHEMA,
  PHASE1_INSTRUCTION_VERSION,
  GatewayInstructionPackageError,
  buildGatewayInstructionPackage,
  gatewayClientInstructions,
  type GatewayInstructionDocument,
  type GatewayInstructionModulePackage,
  type GatewayInstructionPackage,
  type GatewayO6ModuleManifest,
  type GatewayO6ToolBinding,
} from "./instructionPackage.js";
export {
  PROMOTION_GOVERNANCE_FEED_SCHEMA,
  PROMOTION_GOVERNANCE_STATES,
  GatewayPromotionGovernanceRegistry,
  PromotionGovernanceError,
  type PromotionCandidateEvidenceInput,
  type PromotionEvidenceJson,
  type PromotionGovernanceCandidate,
  type PromotionGovernanceFeed,
  type PromotionGovernanceState,
  type PromotionRegistryDefinition,
  type PromotionRegistryMetadata,
  type PromotionRuleMetadata,
} from "./promotionGovernance.js";
export {
  GATEWAY_SERVER_AUTHORED_INPUT_FIELDS,
  ExecutableRegistryError,
  buildGatewayExecutableRegistry,
  projectGatewayInputJsonSchema,
} from "./executableRegistry.js";

export {
  M2_NORTH_FIRST_SLICE_CALLABLE,
  NorthFirstSliceCompositionError,
  buildNorthFirstSliceCallableRegistry,
} from "./northFirstSlice.js";
export {
  ExecutorPortUnavailableError,
  unboundExecutorPort,
  type ExecutorCallContext,
  type ExecutorPort,
  type ExecutorRequest,
  type ExecutorResult,
} from "./executorPort.js";

export {
  RegistrySeedError,
  verifyRegistrySeed,
  type RegistrySeed,
  type RegistrySeedTool,
} from "./registrySeed.js";

// Verified together or not at all: the seed says which tools exist, the
// manifest says the code behind them is what the packager produced. The
// executable registry calls both before exposing callable handlers.
export {
  HandlerManifestError,
  verifyHandlerManifest,
  type HandlerManifest,
  type HandlerManifestModule,
  type VerifyHandlerManifestOptions,
} from "./handlerManifest.js";

export {
  ModeADiscoverySession,
  ModeASchemaBudgetError,
  ModeAToolUnavailableError,
  type ModeAActivationResult,
  type ModeASchemaResult,
  type ModeASearchResult,
} from "./modeADiscovery.js";
export {
  GATEWAY_EXECUTOR_BINDINGS,
  GatewayRegistryView,
  GatewayToolRegistry,
  M2_BOOTSTRAP_TOOL_RECORDS,
  type CapabilityIndex,
  type CapabilityIndexTool,
  type GatewayExecutorBinding,
  type GatewayJsonSchema,
  type GatewayPolicyClass,
  type GatewayMutationScopePolicy,
  type GatewayToolRecord,
} from "./registry.js";

// GW-2 service shell. `main.js`, `imageBootSmoke.js` and `testAdapters.js` are
// deliberately absent: the barrel is imported at image build time and must stay
// side-effect free, and withholding the fixture adapters from the package's only
// export path is half of the guarantee that a fake never reaches production.
export {
  GATEWAY_FIXTURE_ADAPTER_KINDS,
  isFixtureAdapterKind,
  isGatewayPortRefusal,
  portNotImplemented,
  type GatewayPortAdapterKind,
  type GatewayPortErrorCode,
  type GatewayPortName,
  type GatewayPortRefusal,
  type GatewayPortResult,
} from "./gatewayPorts.js";
export {
  GATEWAY_CONFIG_ENV_ALLOWLIST,
  GATEWAY_CONFIG_PROBLEM_MESSAGES,
  GATEWAY_STARTUP_LOG_FIELD_ALLOWLIST,
  loadGatewayConfig,
  startupLogFields,
  type GatewayConfig,
  type GatewayConfigEnvName,
  type GatewayConfigLoadResult,
  type GatewayConfigProblem,
  type GatewayConfigProblemReason,
  type GatewayLogLevel,
  type GatewayNodeEnv,
} from "./config.js";
export {
  GATEWAY_AUTH_CONTRACT_VERSION,
  createUnavailableEntitlementPort,
  createUnavailableIdentityPort,
  isCanonicalMachineFingerprint,
  machineFingerprintClaimsEqual,
  type AuthContext,
  type DeviceAuthContext,
  type EntitlementPort,
  type GatewayClientType,
  type GatewayModuleName,
  type GatewayMachineFingerprint,
  type GatewayRole,
  type IdentityPort,
} from "./authContext.js";
export {
  GATEWAY_CREDENTIAL_SCOPE_SCHEMA,
  GATEWAY_REVOCATION_CURSOR_SCHEMA,
  IDENTITY_DEVICE_SCHEMA,
  IDENTITY_REVOCATION_EVENT_SCHEMA,
  IDENTITY_REVOCATION_HEAD_SCHEMA,
  IDENTITY_TENANT_SEAT_SCHEMA,
  PRODUCTION_IDENTITY_PORT_TRUST_SCHEMA,
  createProductionCredentialScopeLocator,
  createProductionIdentityAuthority,
  type CredentialScopeFailure,
  type CredentialScopeLookupResult,
  type CredentialScopeMutationResult,
  type GatewayCredentialScopeV1,
  type GatewayRevocationCursorV1,
  type IdentityAuthorityChange,
  type IdentityDeviceV2,
  type IdentityMutationResult,
  type IdentityReconciliationRequired,
  type IdentityRevocationConsumeResult,
  type IdentityRevocationEventV1,
  type IdentityRevocationHeadV1,
  type IdentityTenantSeatV1,
  type ProductionCredentialScope,
  type ProductionCredentialScopeLocator,
  type ProductionCredentialScopeLocatorOptions,
  type ProductionCredentialScopeStore,
  type ProductionDeviceAuthContext,
  type ProductionIdentityAuthority,
  type ProductionIdentityManagedResources,
  type ProductionIdentityLifecycleSnapshot,
  type ProductionIdentityLifecycleStage,
  type ProductionIdentityLifecycleState,
  type ProductionIdentityPortTrustMetadata,
  type ProductionIdentityResourceState,
  type ProductionIdentityStoreOptions,
  type ProductionIdentityTrustResource,
  type ProductionNorthIdentityDelegate,
  type ProductionTenantIdentityStore,
  type ProductionTenantStoreOwnership,
  type ProvisionIdentityDeviceInput,
  type RevokeIdentityDeviceInput,
  type RevokeIdentitySeatInput,
} from "./productionIdentityStore.js";
export {
  PRE_PRODUCTION_IDENTITY_CONTRACT_VERSION,
  PreProductionIdentityConfigurationError,
  createPreProductionIdentityAuthority,
  type PreProductionDeviceRevocation,
  type PreProductionEnrollmentDeviceStatus,
  type PreProductionEnrollmentExchange,
  type PreProductionEnrollmentExchangeInput,
  type PreProductionEnrollmentIssue,
  type PreProductionEnrollmentIssueInput,
  type PreProductionIdentityAuthority,
  type PreProductionIdentityConfigurationErrorReason,
  type PreProductionIdentityOptions,
  type PreProductionIdentityRefusal,
  type PreProductionIdentityRefusalReason,
  type PreProductionIdentityResult,
  type PreProductionNorthIdentityFixture,
} from "./preProductionIdentity.js";
export {
  PRE_PRODUCTION_LAN_TEST_PROFILE,
  PreProductionCompositionError,
  createPreProductionLanTestComposition,
  type PreProductionCompositionErrorCode,
  type PreProductionLanTestComposition,
  type PreProductionLanTestCompositionOptions,
  type PreProductionNorthMcpAuthenticator,
  type PreProductionRbpIngressHost,
} from "./preProductionComposition.js";
export {
  PRE_PRODUCTION_ENROLLMENT_PATH,
  createPreProductionEnrollmentEndpoint,
  type PreProductionEnrollmentEndpoint,
  type PreProductionEnrollmentEndpointOptions,
} from "./preProductionEnrollmentEndpoint.js";
export {
  PRE_PRODUCTION_SERVING_CONTRACT_VERSION,
  PreProductionServingError,
  preparePreProductionServing,
  type PreparedPreProductionServing,
  type PreProductionServingDependencies,
  type PreProductionServingDevice,
  type PreProductionServingErrorReason,
  type PreProductionServingOptions,
  type PreProductionServingPrincipal,
} from "./preProductionServing.js";
export {
  createPreProductionRuntimeAdapters,
  type PreProductionRuntimeAdapters,
} from "./preProductionRuntimeAdapters.js";
export {
  PreProductionTlsMaterialError,
  loadPreProductionTlsMaterial,
  type PreProductionTlsFileHandle,
  type PreProductionTlsFileStat,
  type PreProductionTlsMaterialErrorReason,
  type PreProductionTlsMaterialIo,
} from "./preProductionTlsMaterial.js";
export {
  REVAGENT_EVENT_SCHEMA,
  GATEWAY_EVENT_TYPES,
  createUnavailableEventSink,
  type GatewayEventEnvelope,
  type GatewayEventSink,
  type GatewayEventType,
} from "./events.js";
export {
  BoundedEu12EventWriter,
  EU12_EVENT_ENVELOPE_SCHEMA,
  Eu12EventBackpressureError,
  Eu12EventIdempotencyError,
  Eu12EventValidationError,
  InMemoryEu12EventPersistence,
  createExternalLlmMeteringEvent,
  eventEnvelopeDigest,
  eventIdempotencyDigest,
  routeEu12Event,
  summarizeAuditCode,
  summarizeAuditInput,
  summarizeAuditParams,
  validateEu12EventEnvelope,
  type AuditSummaryOptions,
  type BoundedEu12EventWriterOptions,
  type ExternalLlmMeteringObservation,
  type Eu12EventPersistence,
  type Eu12EventRoute,
  type Eu12EventWriteReceipt,
} from "./eventPersistence.js";
export {
  RESULT_REFERENCE_DEFAULT_PAGE_BYTES,
  RESULT_REFERENCE_DEFAULT_TTL_MS,
  RESULT_REFERENCE_MAX_BYTES,
  InMemoryResultObjectStore,
  ResultReferenceIdempotencyError,
  ResultReferenceStore,
  freezeResultReference,
  resultReferenceDigest,
  resultReferenceStorageKey,
  validateResultReferencePageSize,
  type ResultObjectStore,
  type ResultReference,
  type ResultReferencePage,
  type ResultReferenceScope,
  type ResultReferenceStoreOptions,
} from "./resultReferenceStore.js";
export {
  PostgresEu12DataStore,
  RetentionLeaseError,
  RetentionNotDueError,
  canonicalDurableReleaseManifest,
  type CanonicalRetentionClass,
  type PostgresEu12DataStoreOptions,
  type PersistedParityAttribution,
  type RetentionSurface,
} from "./postgresEu12DataStore.js";
export { PostgresEu12EventPersistence } from "./postgresEu12EventPersistence.js";
export {
  RetentionArchiveRunner,
  parseArchivedEventNdjson,
  type RetentionArchiveEventSource,
  type RetentionArchiveRun,
  type RetentionArchiveRunnerOptions,
  type RetentionArchiveClass,
  type RetentionArchiveState,
} from "./retentionArchive.js";
export {
  ReleaseChannelStore,
  canonicalBridgeReleaseManifest,
  type BridgeReleaseChannel,
  type BridgeReleaseContract,
  type ReleaseChannelAuditRecord,
  type ReleaseChannelContract,
  type ReleaseChannelStoreOptions,
  type ReleaseSignatureVerifier,
} from "./releaseChannelStore.js";
export {
  DYING_METRIC_CLASSIFICATIONS,
  SURVIVING_METRIC_DEFINITIONS,
  deriveMetricParity,
  type MetricParityDevice,
  type MetricParityReport,
  type MetricParityRow,
  type MetricParitySource,
  type MetricParityStatus,
} from "./metricParity.js";
export {
  Eu12InvocationRecorder,
  type Eu12InvocationEventWriter,
  type Eu12InvocationInput,
  type Eu12InvocationReceipt,
  type Eu12InvocationResultWriter,
} from "./eventResultLifecycle.js";
export {
  GATEWAY_STORE_CONTRACT_VERSION,
  createUnavailableObjectStore,
  createUnavailableProtocolStore,
  type GatewayProtocolStore,
  type ObjectStorePort,
  type StoreErrorCode,
  type StoreExpectation,
  type StoreOutcome,
  type StoreTransaction,
  type StoredRecord,
} from "./store.js";
export {
  GATEWAY_RECOVERY_CONTRACT_VERSION,
  GATEWAY_RECOVERY_NAMESPACE,
  GatewayRecoveryAuthority,
  type GatewayAuditedRecoveryDecisionPort,
  type GatewayBridgeCumulativeAckReceipt,
  type GatewayBridgeEvidenceLookup,
  type GatewayBridgeResumeAuthorization,
  type GatewayDurableBridgeEvidencePort,
  type GatewayDurableBatchTerminal,
  type GatewayDurableDispatchObservation,
  type GatewayExpectedDispatchBinding,
  type GatewayExpectedDispatchTarget,
  type GatewayExpectedInvocationBinding,
  type GatewayExpectedMutationDispatch,
  type GatewayExpectedVerificationDispatch,
  type GatewayVerifiedBridgeJournalEvidence,
  type GatewayRecoveryAuthorityOptions,
  type GatewayRecoveryDispatchHistory,
  type GatewayRecoveryEvidenceResult,
  type GatewayRecoveryEvidenceCandidate,
  type GatewayRecoveryEvidenceDecision,
  type GatewayRecoveryEvidenceDecisionAudit,
  type GatewayRecoveryInvocationWindow,
  type GatewayRecoveryJournalAttestation,
  type GatewayRecoveryMutationEntry,
  type GatewayRecoveryPendingDispatch,
  type GatewayRecoveryPlanResult,
  type GatewayRecoveryPreflightResult,
  type GatewayRecoveryPrepareResult,
  type GatewayRecoveryProtocolFault,
  type GatewayRecoveryRecord,
  type GatewayRecoveryReconcileResult,
  type GatewayRecoveryResolutionPlan,
  type GatewayRecoveryResolutionPlanItem,
  type GatewayRecoveryResumeResult,
  type GatewayRecoveryStoreFailure,
  type GatewayRecoveryWindowAcquireResult,
  type GatewayRecoveryWindowReleaseResult,
} from "./recoveryAuthority.js";
export {
  createUnavailableGuardrailPort,
  type GuardrailDecision,
  type GuardrailPort,
  type GuardrailRefusalCode,
} from "./guardrails.js";
export {
  RBP_INGRESS_HTTP_FALLBACK_PATHS,
  RBP_INGRESS_MOUNT_PREFIX,
  createConformanceRbpIngressHost,
  createProductionRbpIngressHost,
  createUnavailableRbpIngressHost,
  type ProductionRbpIngressHost,
  type ConformanceRbpIngressHost,
  type RbpIngressHost,
} from "./rbpIngress.js";
export {
  GATEWAY_RBP_SESSION_NAMESPACE,
  GatewayBridgeSessionAuthority,
  GatewayRbpFault,
  type BridgeConnectionChannel,
  type BridgeConnectionOpening,
} from "./bridgeSession.js";
export {
  CodeExecMode,
  ModeBNotImplementedError,
  codeExecSandboxHost,
  generateToolWrapperTree,
  type EngineMode,
  type EngineModeKind,
  type ModelCapabilities,
  type SandboxHost,
} from "./modeB.js";
export {
  GatewayCompositionError,
  GatewayConformancePortError,
  GatewayFixturePortError,
  GatewayM5CompositionError,
  GatewayPreProductionPortError,
  assertProductionPorts,
  buildFastifyOptions,
  createFailClosedPorts,
  createGatewayApp,
  startGatewayServer,
  type GatewayCompositionErrorReason,
  type GatewayServerHandle,
  type GatewayServerOptions,
  type GatewayServerPorts,
  type GatewayServerTlsMaterial,
} from "./server.js";
export { startProductionGatewayHost } from "./productionConformanceHost.js";
export {
  M5_BRIDGE_IDENTITY_AUTHORITY_CONTRACT_VERSION,
  M5BridgeIdentityAuthority,
  createM5BridgeIdentityAuthority,
} from "./m5BridgeIdentityAuthority.js";
export { runProductionConformanceHostCli } from "./productionConformanceHostCli.js";
export { migrateUp } from "./migrate.js";
export {
  PostgresTenantStore,
  type OidcPrincipalInput,
  type TenantDeviceSummary,
} from "./postgresTenantStore.js";
export {
  createOidcIdentityPort,
  createOidcNorthMcpAuthenticator,
  type OidcIdentityOptions,
  type OidcIdentityRepository,
} from "./oidcIdentity.js";
export { createAuthenticatedTenantReadNorthMcp } from "./authenticatedTenantRead.js";
export {
  BRIDGE_MANIFEST_CANONICALIZATION,
  BRIDGE_MANIFEST_SIGNED_OBJECT,
  bridgeManifestDigest,
  parseBridgeManifestTrustedKeys,
  validateBridgeUpdateManifest,
  verifyBridgeManifestSignature,
  type BridgeManifestSignatureEnvelope,
  type BridgeManifestTrustedKey,
} from "./bridgeManifestSignature.js";
export {
  BridgeReleaseObjectError,
  FilesystemBridgeReleaseObjectStore,
} from "./bridgeReleaseObjectStore.js";
export {
  createBridgeUpdateEndpoint,
  type BridgeUpdateEndpointOptions,
  type BridgeUpdateReleaseReader,
} from "./bridgeUpdateEndpoint.js";
export {
  M5_ACTIVE_REVOKE_BOUND_MS,
  M5_ENROLLMENT_ENTITLEMENT_CONTRACT_VERSION,
  M5EnrollmentEntitlementControlPlane,
  type M5BridgeCloseControl,
  type M5BridgeConnection,
  type M5BridgeExecutor,
  type M5Capability,
  type M5DispatchResult,
  type M5EnrollmentEntitlementFailure,
  type M5EnrollmentEntitlementFailureReason,
  type M5EnrollmentEntitlementOptions,
  type M5EnrollmentEntitlementResult,
  type M5EnrollmentExchange,
  type M5IssuedEnrollmentCode,
  type M5MintEnrollmentInput,
  type M5ResolvedDeviceCredential,
  type M5RevocationResult,
  type M5RotatedCredential,
  type M5SeatAssignment,
} from "./m5EnrollmentEntitlement.js";
export {
  M5_BRIDGE_ENROLLMENT_MAX_BODY_BYTES,
  M5_BRIDGE_ENROLLMENT_PATH,
  mountM5BridgeEnrollmentEndpoint,
  type M5BridgeEnrollmentEndpointOptions,
} from "./m5EnrollmentEntitlementEndpoint.js";
export {
  ConformanceCredentialAuthority,
  DigestFileConformanceObjectStore,
  SqliteConformanceProtocolStore,
  createConformanceSupportingPorts,
} from "./conformanceEphemeralAdapters.js";
// GW-3 executor and policy seed.
export {
  DYNAMIC_CODE_TOOL,
  E5_CONFIRM_CLASS_TOOLS,
  E5_EXPECTED_TOTALS,
  E5_DOCUMENT_RECOVERY_TOOLS,
  E5_NO_RECOVERY_TOOLS,
  E5_SESSION_RECOVERY_TOOLS,
  E5_TOOL_BINDINGS,
  ToolBindingError,
  verifyToolBindings,
  mutationScopePolicyForTool,
  type ToolBindingRow,
} from "./toolBindings.js";
export {
  CatalogError,
  EntitledCatalogView,
  buildCatalog,
  entitleAll,
  entitleOnly,
  type CatalogEntry,
  type EntitlementDecision,
} from "./entitledRegistry.js";
export {
  GW9_ALLOWED_OUTPUT_CONTENT_TYPES,
  GW9_ALLOWED_UPLOAD_CONTENT_TYPES,
  GatewayResourceAuthority,
  GatewayResourceError,
  resourceScopeFromAuth,
  type BoundedGatewayResult,
  type GatewayArtifactRef,
  type GatewayResourceAuthorityOptions,
  type GatewayResourceErrorCode,
  type GatewayResourceKind,
  type GatewayResourceRead,
  type GatewayResourceScope,
  type GatewayResultRef,
  type IngestRbpArtifactCarrierInput,
  type UploadArtifactInput,
} from "./resourceAuthority.js";
