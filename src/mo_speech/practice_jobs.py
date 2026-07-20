from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from threading import Event, Lock, Thread
from typing import Callable
from uuid import uuid4

PracticeStage = dict[str, object]
PracticeResult = dict[str, object]
PracticeProgressReporter = Callable[..., None]
PracticeJobWorker = Callable[[PracticeProgressReporter], PracticeResult]


class PracticeJobFailure(RuntimeError):
    def __init__(self, *, current_stage: PracticeStage, error: object) -> None:
        super().__init__(str(error))
        self.current_stage = current_stage
        self.error = error


@dataclass
class PracticeJob:
    job_id: str
    status: str
    stages: list[PracticeStage]
    current_stage: PracticeStage | None = None
    result: PracticeResult | None = None
    error: object = None
    completed: Event = field(default_factory=Event, repr=False)


@dataclass
class PracticeJobStore:
    jobs: dict[str, PracticeJob] = field(default_factory=dict)
    lock: Lock = field(default_factory=Lock)

    def start(
        self,
        worker: PracticeJobWorker,
        *,
        planned_stages: list[PracticeStage],
    ) -> dict[str, object]:
        stages = deepcopy(planned_stages)
        job = PracticeJob(
            job_id=f"local-{uuid4().hex}",
            status="queued",
            stages=stages,
            current_stage=deepcopy(stages[0]) if stages else None,
        )
        with self.lock:
            self.jobs[job.job_id] = job
        Thread(target=self._run, args=(job.job_id, worker), daemon=True).start()
        return self.snapshot(job.job_id)

    def has(self, job_id: str) -> bool:
        with self.lock:
            return job_id in self.jobs

    def snapshot(self, job_id: str) -> dict[str, object]:
        with self.lock:
            job = self.jobs[job_id]
            return {
                "job_id": job.job_id,
                "status": job.status,
                "current_stage": deepcopy(job.current_stage),
                "stages": deepcopy(job.stages),
                "metrics": {},
                "result": deepcopy(job.result),
                "error": deepcopy(job.error),
            }

    def wait(self, job_id: str, *, timeout: float) -> dict[str, object]:
        with self.lock:
            completed = self.jobs[job_id].completed
        if not completed.wait(timeout=timeout):
            raise TimeoutError(f"practice job did not finish within {timeout} seconds")
        return self.snapshot(job_id)

    def _run(self, job_id: str, worker: PracticeJobWorker) -> None:
        with self.lock:
            self.jobs[job_id].status = "running"

        def report(
            *,
            stage: str,
            label: str,
            provider: str,
            model: str,
            detail: str = "",
        ) -> None:
            item: PracticeStage = {
                "stage": stage,
                "label": label,
                "provider": provider,
                "model": model,
            }
            if detail:
                item["detail"] = detail
            with self.lock:
                job = self.jobs[job_id]
                job.current_stage = item
                for index, existing in enumerate(job.stages):
                    if existing.get("stage") == stage:
                        job.stages[index] = item
                        break
                else:
                    job.stages.append(item)

        try:
            result = worker(report)
            with self.lock:
                job = self.jobs[job_id]
                job.status = "succeeded"
                job.result = result
                job.current_stage = {
                    "stage": "complete",
                    "label": "完了しました",
                    "provider": "",
                    "model": "",
                }
        except PracticeJobFailure as error:
            with self.lock:
                job = self.jobs[job_id]
                job.status = "failed"
                job.current_stage = deepcopy(error.current_stage)
                job.error = deepcopy(error.error)
        except Exception as error:
            with self.lock:
                job = self.jobs[job_id]
                job.status = "failed"
                job.current_stage = {
                    "stage": "failed",
                    "label": "処理に失敗しました",
                    "provider": "",
                    "model": "",
                }
                job.error = {
                    "code": "practice_job_failed",
                    "message": str(error),
                    "retryable": True,
                }
        finally:
            with self.lock:
                self.jobs[job_id].completed.set()
