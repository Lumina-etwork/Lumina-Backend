import { Priority } from './deficit-round-robin';

export class PriorityClassifier {
    static classify(flowMetadata: any): Priority {
        // Simple mapping based on flow metadata properties
        if (flowMetadata.isInteractive || flowMetadata.protocol === 'VOIP') {
            return Priority.High;
        }
        
        if (flowMetadata.isBulk || flowMetadata.protocol === 'FTP') {
            return Priority.Low;
        }
        
        return Priority.Medium;
    }
}
