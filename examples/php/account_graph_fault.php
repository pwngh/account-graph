<?php
/**
 * Carries the graph's fault code, retry advice and structured detail.
 *
 * Requires PHP 7.2 or later.
 *
 * @filename account_graph_fault.php
 */
class account_graph_fault extends RuntimeException
{
    /** @var string */
    public $fault_code;
    /** @var bool */
    public $retryable;
    /** @var array */
    public $detail;

    /**
     * Construct a fault from the contract fields.
     *
     * 'Code' => '', // required, string, the graph fault code.
     * --
     * 'Retryable' => false, // optional, bool, whether the same request may be retried.
     * --
     * 'Detail' => [], // optional, array, additional fields supplied by the graph.
     * --
     * 'Message' => '', // optional, string, local diagnostic text. Defaults to Code.
     *
     * @param array $config Fault fields.
     *        (for example ['Code' => 'AUTH.REJECTED'])
     * @return void
     */
    public function __construct(array $config = [])
    {
        if (empty($config['Code']) || !is_string($config['Code'])) {
            throw new InvalidArgumentException('Code is required.');
        }
        $retryable = array_key_exists('Retryable', $config) ? $config['Retryable'] : false;
        $detail = array_key_exists('Detail', $config) ? $config['Detail'] : [];
        $message = array_key_exists('Message', $config) ? $config['Message'] : '';
        if (!is_bool($retryable)) {
            throw new InvalidArgumentException('Retryable must be a boolean.');
        }
        if (!is_array($detail)) {
            throw new InvalidArgumentException('Detail must be an array.');
        }
        if (!is_string($message)) {
            throw new InvalidArgumentException('Message must be a string.');
        }
        $this->fault_code = $config['Code'];
        $this->retryable = $retryable;
        $this->detail = $detail;
        $message = $message === '' ? $this->fault_code : $message;
        parent::__construct($message);
    }

    /**
     * Keep sensitive call arguments out of an uncaught exception's text.
     *
     * @return string The fault class and code.
     */
    public function __toString(): string
    {
        return 'account_graph_fault: ' . $this->fault_code;
    }
}
