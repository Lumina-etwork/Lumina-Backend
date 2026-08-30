const cron = require("node-cron");
const { BackupVerificationJob } = require("../../src/jobs/backupVerificationJob");

jest.mock("node-cron", () => ({
  schedule: jest.fn(() => ({ stop: jest.fn() })),
}));

describe("BackupVerificationJob", () => {
  let serviceMock;
  let configMock;

  beforeEach(() => {
    jest.clearAllMocks();
    serviceMock = {
      runFullVerification: jest.fn().mockResolvedValue({ status: "ok" }),
      verifyLatestBackup: jest.fn().mockResolvedValue({ status: "ok" }),
      getStatus: jest.fn().mockReturnValue({ enabled: true }),
      historyStore: { list: jest.fn().mockReturnValue([]) },
    };
    configMock = {
      enabled: true,
      restoreTestEnabled: true,
      backupCron: "0 2 * * *",
      restoreTestCron: "0 4 * * 0",
    };
  });

  test("schedules both the daily backup and the weekly restore test", () => {
    const job = new BackupVerificationJob({ config: configMock, service: serviceMock });

    job.start();

    expect(cron.schedule).toHaveBeenCalledTimes(2);
    expect(cron.schedule).toHaveBeenCalledWith("0 2 * * *", expect.any(Function));
    expect(cron.schedule).toHaveBeenCalledWith("0 4 * * 0", expect.any(Function));
  });

  test("skips the restore test schedule when disabled", () => {
    const job = new BackupVerificationJob({
      config: { ...configMock, restoreTestEnabled: false },
      service: serviceMock,
    });

    job.start();

    expect(cron.schedule).toHaveBeenCalledTimes(1);
  });

  test("does not schedule anything when the job is disabled", () => {
    const job = new BackupVerificationJob({
      config: { ...configMock, enabled: false },
      service: serviceMock,
    });

    job.start();

    expect(cron.schedule).not.toHaveBeenCalled();
  });

  test("stop() stops all scheduled tasks", () => {
    const job = new BackupVerificationJob({ config: configMock, service: serviceMock });
    job.start();

    job.stop();

    expect(job.cronJobs).toHaveLength(0);
  });

  test("runScheduled dispatches to the full verification pipeline", async () => {
    const job = new BackupVerificationJob({ config: configMock, service: serviceMock });

    const report = await job.runScheduled("backup");

    expect(serviceMock.runFullVerification).toHaveBeenCalled();
    expect(report.status).toBe("ok");
  });

  test("runScheduled dispatches to the restore test for restore-test mode", async () => {
    const job = new BackupVerificationJob({ config: configMock, service: serviceMock });

    const report = await job.runScheduled("restore-test");

    expect(serviceMock.verifyLatestBackup).toHaveBeenCalled();
    expect(report.status).toBe("ok");
  });

  test("runScheduled swallows service errors into a failed report", async () => {
    serviceMock.runFullVerification.mockRejectedValue(new Error("boom"));
    const job = new BackupVerificationJob({ config: configMock, service: serviceMock });

    const report = await job.runScheduled("backup");

    expect(report.status).toBe("failed");
    expect(report.error).toBe("boom");
  });

  test("exposes manual trigger methods", async () => {
    const job = new BackupVerificationJob({ config: configMock, service: serviceMock });

    await job.runFullVerification();
    await job.runRestoreTest();

    expect(serviceMock.runFullVerification).toHaveBeenCalled();
    expect(serviceMock.verifyLatestBackup).toHaveBeenCalled();
  });

  test("getStatus includes scheduling information", () => {
    const job = new BackupVerificationJob({ config: configMock, service: serviceMock });

    const status = job.getStatus();

    expect(status.enabled).toBe(true);
    expect(status.lastScheduledRun).toBeNull();
  });
});
